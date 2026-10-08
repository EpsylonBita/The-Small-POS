import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { bridge, notices, translation } = vi.hoisted(() => ({
  bridge: { ecr: { getDevices: vi.fn(), getAllStatuses: vi.fn(), updateDevice: vi.fn(), addDevice: vi.fn(), removeDevice: vi.fn(),
    testConnection: vi.fn(), testPrint: vi.fn(), connectDevice: vi.fn(), disconnectDevice: vi.fn(), getDeviceAdmission: vi.fn() },
  settings: { get: vi.fn(), set: vi.fn() } },
  notices: { success: vi.fn(), error: vi.fn() },
  translation: { t: (key: string, fallback?: string | { defaultValue?: string }) =>
    typeof fallback === 'string' ? fallback : fallback?.defaultValue ?? key },
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
const admissionAnswer = (cashAdmitted: boolean) => ({
  success: true,
  cardTerminal: { admitted: false, fetchedAt: '2026-10-08T09:00:00Z' },
  cashRegister: { admitted: cashAdmitted, fetchedAt: '2026-10-08T09:00:00Z', mode: 'fiscal_device', status: cashAdmitted ? 'connected' : 'pending' },
});
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
    bridge.ecr.getDeviceAdmission.mockResolvedValue(admissionAnswer(true));
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

  const capDevice = { ...device, protocol: 'cap_driver', settings: { capturePath: 'C:\\Capture', outputPath: 'C:\\Capture\\Output',
    serviceName: 'CapDriverSVC', transactionTimeoutMs: 120000, cashPaymentCode: 1, cardPaymentCode: 2, eftPosIndex: 1,
    fileEncoding: 'utf-8', probeDeviceTcp: false },
    taxRates: [{ code: 'A', rate: '24', label: 'Standard', department: 1 }, { code: 'B', rate: '13', label: 'Reduced', department: 2 },
      { code: 'C', rate: '6', label: 'Super Reduced', department: 3 }, { code: 'D', rate: '0', label: 'Zero', department: 4 }] };

  it('keeps a saved CAP voucher code through an unrelated edit and refuses a colliding one', async () => {
    bridge.ecr.getDevices.mockResolvedValue({ success: true, devices: [{ ...capDevice, settings: { ...capDevice.settings, voucherPaymentCode: 5 } }] });
    bridge.ecr.updateDevice.mockResolvedValue({ success: true });
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Edit', exact: true }));
    const voucher = screen.getByLabelText('Voucher code (optional)') as HTMLInputElement;
    expect(voucher.value).toBe('5');
    fireEvent.change(voucher, { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    await waitFor(() => expect(notices.error).toHaveBeenCalledWith('The voucher code must be 2–20 and differ from the cash and card codes'));
    expect(bridge.ecr.updateDevice).not.toHaveBeenCalled();
    fireEvent.change(voucher, { target: { value: '5' } });
    fireEvent.change(screen.getByDisplayValue('Register A'), { target: { value: 'Edited Register' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    await waitFor(() => expect(bridge.ecr.updateDevice).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(bridge.ecr.updateDevice.mock.calls[0])).toContain('"voucherPaymentCode":5');
  });

  it('writes no CAP voucher code when none was configured', async () => {
    bridge.ecr.getDevices.mockResolvedValue({ success: true, devices: [capDevice] });
    bridge.ecr.updateDevice.mockResolvedValue({ success: true });
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Edit', exact: true }));
    expect((screen.getByLabelText('Voucher code (optional)') as HTMLInputElement).value).toBe('');
    fireEvent.change(screen.getByDisplayValue('Register A'), { target: { value: 'Edited Register' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    await waitFor(() => expect(bridge.ecr.updateDevice).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(bridge.ecr.updateDevice.mock.calls[0])).not.toMatch(/voucher/i);
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

  // Founder rule 08/10/2026: a cash register is inert until MyData is in
  // fiscal-device mode with its setup finished (status connected).
  it('shows a non-admitted register with its plugin state and lets it be disabled', async () => {
    bridge.ecr.getDeviceAdmission.mockResolvedValue(admissionAnswer(false));
    bridge.ecr.updateDevice.mockResolvedValue({ success: true });
    await open();
    expect(bridge.ecr.getDeviceAdmission).toHaveBeenCalledWith({ refresh: true });
    expect(await screen.findByText(/Needs its plugin: fiscal cash registers stay inactive/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Disable', exact: true }));
    await waitFor(() => expect(bridge.ecr.updateDevice).toHaveBeenCalledExactlyOnceWith('cash-1', { enabled: false }));
    await waitFor(() => expect(notices.success).toHaveBeenCalledWith('Device disabled'));
    expect(screen.getByText('Disabled')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Disable', exact: true })).toBeNull();
  });

  it('shows no plugin warning for an admitted register', async () => {
    await open();
    await waitFor(() => expect(bridge.ecr.getDeviceAdmission).toHaveBeenCalled());
    expect(screen.queryByText(/Needs its plugin/)).toBeNull();
  });

  async function fillNewRegister() {
    fireEvent.click(screen.getByRole('button', { name: 'Add Device', exact: true }));
    fireEvent.change(screen.getByPlaceholderText('e.g., Main Cash Register'), { target: { value: 'Register B' } });
    fireEvent.change(screen.getByDisplayValue('Choose verified protocol…'), { target: { value: 'generic' } });
    fireEvent.change(screen.getByPlaceholderText('COM3'), { target: { value: 'COM6' } });
  }
  const saveNewRegister = () =>
    fireEvent.click(screen.getAllByRole('button', { name: 'Add Device', exact: true }).at(-1)!);

  it('refuses adding an enabled register before native while MyData is not admitted, but saves it disabled', async () => {
    bridge.ecr.getDeviceAdmission.mockResolvedValue(admissionAnswer(false));
    bridge.ecr.addDevice.mockResolvedValue({ success: true });
    await open();
    await fillNewRegister();
    saveNewRegister();
    await waitFor(() => expect(notices.error).toHaveBeenCalledWith(expect.stringMatching(/This cash register cannot be enabled/)));
    expect(bridge.ecr.addDevice).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Enabled' }));
    saveNewRegister();
    await waitFor(() => expect(bridge.ecr.addDevice).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      deviceType: 'cash_register', enabled: false, name: 'Register B',
    })));
  });

  it('maps a native DEVICE_NOT_ADMITTED refusal to the localized message', async () => {
    bridge.ecr.addDevice.mockResolvedValue({ success: false, code: 'DEVICE_NOT_ADMITTED', deviceType: 'cash_register', error: 'Device type cash_register is not admitted' });
    await open();
    await fillNewRegister();
    saveNewRegister();
    await waitFor(() => expect(notices.error).toHaveBeenCalledWith(expect.stringMatching(/needs the store's MyData plugin in fiscal device mode/)));
    expect(screen.getByDisplayValue('Register B')).toBeInTheDocument();
  });

  it('keeps renaming an enabled, non-admitted register possible without resending enabled', async () => {
    bridge.ecr.getDeviceAdmission.mockResolvedValue(admissionAnswer(false));
    bridge.ecr.updateDevice.mockResolvedValue({ success: true });
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Edit', exact: true }));
    fireEvent.change(screen.getByDisplayValue('Register A'), { target: { value: 'Register A2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    await waitFor(() => expect(bridge.ecr.updateDevice).toHaveBeenCalledTimes(1));
    const [id, updates] = bridge.ecr.updateDevice.mock.calls[0];
    expect(id).toBe('cash-1');
    expect(updates).toMatchObject({ name: 'Register A2' });
    // Native refuses `enabled` / a device type for an enabled, non-admitted device: neither is re-sent unchanged.
    expect(updates).not.toHaveProperty('enabled');
    expect(updates).not.toHaveProperty('deviceType');
  });
});
