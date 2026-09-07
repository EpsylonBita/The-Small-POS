import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { bridge, notices, translation } = vi.hoisted(() => ({
  bridge: { ecr: { getDevices: vi.fn(), getAllStatuses: vi.fn(), updateDevice: vi.fn(), addDevice: vi.fn(), removeDevice: vi.fn(),
    testConnection: vi.fn(), testPrint: vi.fn(), connectDevice: vi.fn(), disconnectDevice: vi.fn() },
  settings: { get: vi.fn(), set: vi.fn() } },
  notices: { success: vi.fn(), error: vi.fn() },
  translation: { t: (key: string, fallback?: string) => fallback ?? key },
}));
vi.mock('../../../../lib', () => ({ getBridge: () => bridge, onEvent: vi.fn(), offEvent: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => translation }));
vi.mock('react-hot-toast', () => ({ toast: notices }));
vi.mock('../../ui/pos-glass-components', () => ({
  POSGlassSwitch: ({ checked, onChange, ...props }: any) => <input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} {...props} />,
}));

import { CashRegisterSection } from '../CashRegisterSection';

const device = { id: 'cash-1', name: 'Register A', deviceType: 'cash_register', brand: 'Generic', protocol: 'generic',
  connectionType: 'network', connectionDetails: { ip: '127.0.0.1', port: 9100 }, printMode: 'pos_sends_receipt', status: 'disconnected', enabled: true };
async function open() {
  render(<CashRegisterSection />);
  await screen.findByText('Register A');
}

describe('cash register device actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bridge.settings.get.mockResolvedValue(true);
    bridge.settings.set.mockResolvedValue({ success: true });
    bridge.ecr.getDevices.mockResolvedValue({ success: true, devices: [device] });
    bridge.ecr.getAllStatuses.mockResolvedValue({ success: true, statuses: [] });
    bridge.ecr.testConnection.mockResolvedValue({ success: true, connected: true });
    bridge.ecr.connectDevice.mockResolvedValue({ success: true });
    bridge.ecr.disconnectDevice.mockResolvedValue({ success: true });
    bridge.ecr.testPrint.mockResolvedValue({ success: true });
  });
  afterEach(cleanup);

  it('rejects success:true with connected:false and does not enable print', async () => {
    bridge.ecr.testConnection.mockResolvedValue({ success: true, connected: false });
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Test Connection' }));
    await screen.findByText('Device did not respond to the connection test');
    expect(notices.success).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Test Print' })).toBeDisabled();
  });

  it('keeps a reachable probe separate from a real connect/disconnect and gates test print', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Test Connection' }));
    await screen.findByText('Device reachable');
    expect(screen.getByRole('button', { name: 'Test Print' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Connect', exact: true }));
    await screen.findByRole('button', { name: 'Disconnect', exact: true });
    expect(bridge.ecr.connectDevice).toHaveBeenCalledExactlyOnceWith('cash-1');
    fireEvent.click(screen.getByRole('button', { name: 'Test Print' }));
    await waitFor(() => expect(bridge.ecr.testPrint).toHaveBeenCalledExactlyOnceWith('cash-1'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Disconnect' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await screen.findByRole('button', { name: 'Connect', exact: true });
    expect(bridge.ecr.disconnectDevice).toHaveBeenCalledExactlyOnceWith('cash-1');
    expect(screen.getByRole('button', { name: 'Test Print' })).toBeDisabled();
  });

  it('does not trust a connected label persisted before this session', async () => {
    bridge.ecr.getDevices.mockResolvedValue({ success: true, devices: [{ ...device, status: 'connected' }] });
    await open();
    expect(screen.getByText('Connection not verified')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Test Print' })).toBeDisabled();
  });

  it('restores an existing registered connection from the manager snapshot on mount', async () => {
    bridge.ecr.getAllStatuses.mockResolvedValue({ success: true, statuses: [{ deviceId: 'cash-1', connected: true }] });
    await open();
    expect(screen.getByRole('button', { name: 'Disconnect', exact: true })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Test Print' })).toBeEnabled();
    expect(bridge.ecr.connectDevice).not.toHaveBeenCalled();
    expect(bridge.ecr.getAllStatuses).toHaveBeenCalledTimes(1);
  });

  it('leaves a persisted connection unverified when the manager snapshot fails', async () => {
    bridge.ecr.getDevices.mockResolvedValue({ success: true, devices: [{ ...device, status: 'connected' }] });
    bridge.ecr.getAllStatuses.mockRejectedValue(new Error('Status unavailable'));
    await open();
    expect(screen.getByText('Connection not verified')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Test Print' })).toBeDisabled();
  });

  it('retains the edit form when the native update returns failure', async () => {
    bridge.ecr.updateDevice.mockResolvedValue({ success: false, error: 'Device not found' });
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Edit', exact: true }));
    const name = screen.getByDisplayValue('Register A');
    fireEvent.change(name, { target: { value: 'Edited Register' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    await waitFor(() => expect(notices.error).toHaveBeenCalledWith('Device not found'));
    expect(screen.getByDisplayValue('Edited Register')).toBeInTheDocument();
    expect(notices.success).not.toHaveBeenCalled();
  });

  it('retains a device when removal resolves success:false', async () => {
    bridge.ecr.removeDevice.mockResolvedValue({ success: false });
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Delete', exact: true }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete', exact: true }).at(-1)!);
    await waitFor(() => expect(notices.error).toHaveBeenCalled());
    expect(screen.getByText('Register A')).toBeInTheDocument();
    expect(notices.success).not.toHaveBeenCalled();
  });

  it('shows a failed load with retry instead of a false empty device list', async () => {
    bridge.ecr.getDevices.mockResolvedValueOnce({ success: false, error: 'Database busy' });
    render(<CashRegisterSection />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Database busy');
    expect(screen.queryByText('No cash register devices configured')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('Register A');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
