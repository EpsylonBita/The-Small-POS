import { describe, expect, it, vi } from 'vitest';
import {
  buildMyDataDeviceSettings, DEFAULT_MYDATA_CAP_SETTINGS, MYDATA_FISCAL_DEVICE_ID,
  myDataConnectionTypeFromSaved, readMyDataCapSettings, verifyAndSaveMyDataDevice,
  getMyDataCapPrefill,
  myDataCapTargetMatches,
} from '../mydata-device-setup';

const custom = {
  ...DEFAULT_MYDATA_CAP_SETTINGS, capturePath: 'D:\\Vendor\\In', outputPath: 'D:\\Vendor\\Out',
  serviceName: 'VendorCAP', fileEncoding: 'windows-1253' as const,
  transactionTimeoutMs: 180000, cashPaymentCode: 4, cardPaymentCode: 7, eftPosIndex: 8,
};
const connection = { type: 'network', host: '192.168.1.50', port: 1234, protocol: 'cap_driver', brand: 'RBS', model: 'configured model' };
const device = () => ({ id: MYDATA_FISCAL_DEVICE_ID, connectionType: 'network', settings: buildMyDataDeviceSettings('cap_driver', 'configured model', null, custom) });
const setup = () => ({
  addDevice: vi.fn().mockResolvedValue({ success: true }), updateDevice: vi.fn().mockResolvedValue({ success: true }),
  connectDevice: vi.fn().mockResolvedValue({ success: true }), testConnection: vi.fn().mockResolvedValue({ success: true, connected: true }),
});

describe('myDATA local device setup', () => {
  it('requires an actual supported running CAP target matching LAN or COM and baud', () => {
    const status = { success: true, platformSupported: true, serviceInstalled: true, serviceRunning: true, target: { type: 'network' as const, host: '192.168.1.50' } };
    const draft = { type: 'network' as const, host: '192.168.1.50', serialPort: '', baudRate: '9600' };
    expect(myDataCapTargetMatches(status, draft)).toBe(true);
    expect(myDataCapTargetMatches(status, { ...draft, host: '192.168.1.169' })).toBe(false);
    expect(myDataCapTargetMatches({ ...status, target: undefined }, draft)).toBe(false);
    expect(myDataCapTargetMatches({ ...status, platformSupported: false }, draft)).toBe(false);
    expect(myDataCapTargetMatches({ ...status, success: false }, draft)).toBe(false);
    expect(myDataCapTargetMatches({ ...status, serviceRunning: false }, draft)).toBe(false);
    for (const code of ['CAP_SETUP_CODEPAGE_UNSUPPORTED', 'CONFIG_UNREADABLE', 'CAP_SETUP_CODEPAGE_MISSING', 'INSTALLER_LAUNCHED', '']) {
      expect(myDataCapTargetMatches({ ...status, code }, draft)).toBe(false);
    }
    const serial = { ...status, target: { type: 'usb_serial' as const, serial_port: 'COM7', baud_rate: 19200 } };
    expect(myDataCapTargetMatches(serial, { ...draft, type: 'usb_serial', serialPort: 'com7', baudRate: '19200' })).toBe(true);
    expect(myDataCapTargetMatches(serial, { ...draft, type: 'usb_serial', serialPort: 'COM7' })).toBe(false);
    expect(myDataCapTargetMatches(null, draft)).toBe(false);
  });
  it('defaults a new draft to LAN and retains saved serial/Bluetooth choices', () => {
    expect(myDataConnectionTypeFromSaved(undefined)).toBe('network');
    expect(myDataConnectionTypeFromSaved({ type: 'usb_serial' })).toBe('usb_serial');
    expect(myDataConnectionTypeFromSaved({ type: 'bluetooth' })).toBe('bluetooth');
  });

  it('reconnects without resetting local CAP paths, encoding, service, timeout, payment codes or EFT options', async () => {
    const existing = { protocol: 'rbs_cap_driver', settings: { ...custom, probeDeviceTcp: true, vendorOption: { retryDelay: 750 }, requireService: false } };
    const settings = buildMyDataDeviceSettings('cap_driver', 'configured model', existing, readMyDataCapSettings(existing.settings));
    const ecr = setup();
    const save = vi.fn().mockResolvedValue({ success: true });
    await verifyAndSaveMyDataDevice(ecr, { ...device(), settings }, true, 'terminal-a', connection, save);
    expect(ecr.updateDevice).toHaveBeenCalledWith(MYDATA_FISCAL_DEVICE_ID, expect.objectContaining({ settings: expect.objectContaining({ ...custom, probeDeviceTcp: true, vendorOption: { retryDelay: 750 }, requireService: true }) }));
    expect(ecr.addDevice).not.toHaveBeenCalled();
    const remote = save.mock.calls[0][0];
    expect(remote.device_connection).not.toHaveProperty('capturePath');
    expect(remote.device_connection).not.toHaveProperty('settings');
    expect(remote.device_connection.verification).toMatchObject({ terminal_id: 'terminal-a', protocol_handshake: true });
    expect(ecr.testConnection.mock.invocationCallOrder[0]).toBeLessThan(save.mock.invocationCallOrder[0]);
  });

  it('reads legacy native settings without resetting configured values', () => {
    expect(readMyDataCapSettings({ capture_path: 'D:\\Capture', file_encoding: 'cp1253', eft_pos_index: 6 })).toMatchObject({ capturePath: 'D:\\Capture', outputPath: 'D:\\Capture\\Output', fileEncoding: 'windows-1253', eftPosIndex: 6 });
    expect(readMyDataCapSettings({ fileEncoding: 'ANSI' }).fileEncoding).toBe('windows-1253');
  });

  it('allows service-owned CAP LAN without inventing a port', async () => {
    const ecr = setup();
    const save = vi.fn().mockResolvedValue({ success: true });
    const { port: _port, ...withoutPort } = connection;
    await verifyAndSaveMyDataDevice(ecr, device(), false, 'terminal-a', withoutPort, save);
    expect(save.mock.calls[0][0].device_connection).not.toHaveProperty('port');
  });

  it.each(['tcp-probe', 'generic'])('requires an explicit port for %s', async mode => {
    const ecr = setup();
    const save = vi.fn();
    const { port: _port, ...withoutPort } = connection;
    await expect(verifyAndSaveMyDataDevice(ecr,
      { ...device(), settings: { ...device().settings, probeDeviceTcp: mode === 'tcp-probe' } }, false, 'terminal-a',
      { ...withoutPort, protocol: mode === 'generic' ? 'generic' : 'cap_driver' }, save)).rejects.toThrow();
    expect(ecr.addDevice).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('does not carry incompatible protocol options or credential-like fields forward', () => {
    const existing = { protocol: 'cap_driver', settings: { ...custom, accessToken: 'secret', DEVKEY: 'secret', unlock_key: 'secret', CapDriverKey: 'secret', nested: { api_key: 'secret', retryDelay: 3 }, vendorOption: 'kept' } };
    const compatible = buildMyDataDeviceSettings('cap_driver', 'model', existing, custom);
    expect(compatible).not.toHaveProperty('accessToken');
    expect(compatible).not.toHaveProperty('DEVKEY');
    expect(compatible).not.toHaveProperty('unlock_key');
    expect(compatible).not.toHaveProperty('CapDriverKey');
    expect(compatible.nested).toEqual({ retryDelay: 3 });
    const changed = buildMyDataDeviceSettings('generic', 'model', existing, custom);
    expect(changed).toEqual({ mydataManaged: true, model: 'model', protocolProfile: 'generic' });
  });

  it.each(['rbs_cap_driver', 'mat_cap_driver'])('enforces CAP validation for installed alias %s', async protocol => {
    expect(() => buildMyDataDeviceSettings(protocol, 'model', null, { ...custom, eftPosIndex: 0 })).toThrow('Invalid CAP');
    const ecr = setup();
    const save = vi.fn();
    await expect(verifyAndSaveMyDataDevice(ecr, { ...device(), settings: { ...device().settings, requireService: false } }, false, 'terminal-a', { ...connection, protocol }, save)).rejects.toThrow('Invalid CAP');
    expect(save).not.toHaveBeenCalled();
  });

  it('prefills only absent local settings and target fields', () => {
    const detected = { settings: { capturePath: 'D:\\Installed', fileEncoding: 'windows-1253' as const }, target: { type: 'network' as const, host: '192.168.1.8' } };
    expect(getMyDataCapPrefill(detected, {}, {}, new Set())).toEqual(detected);
    expect(getMyDataCapPrefill(detected, { type: 'network', host: '192.168.1.9' }, { capture_path: 'D:\\Saved' }, new Set())).toEqual({ settings: { fileEncoding: 'windows-1253' }, target: { type: 'network' } });
    expect(getMyDataCapPrefill(detected, {}, {}, new Set(['target', 'cap.capturePath', 'cap.fileEncoding']))).toEqual({ settings: {} });
    expect(getMyDataCapPrefill(detected, { type: 'usb_serial', serial_port: 'COM7' }, {}, new Set()).target).toBeUndefined();
  });

  it.each([
    { capturePath: '' }, { fileEncoding: 'latin1' }, { transactionTimeoutMs: 0 },
    { cashPaymentCode: 21 }, { cardPaymentCode: 0 }, { eftPosIndex: 100 },
  ])('rejects invalid CAP settings before saving native or connected state: %j', async invalid => {
    const ecr = setup();
    const save = vi.fn();
    const settings = { ...device().settings, ...invalid };
    await expect(verifyAndSaveMyDataDevice(ecr, { ...device(), settings }, false, 'terminal-a', connection, save)).rejects.toThrow('Invalid CAP');
    expect(ecr.addDevice).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it.each(['save', 'connect', 'handshake', 'connected', 'missing-connected', 'malformed-connected'])('cannot publish connected when native %s fails', async stage => {
    const ecr = setup();
    if (stage === 'save') ecr.addDevice.mockResolvedValue({ success: false });
    if (stage === 'connect') ecr.connectDevice.mockResolvedValue({ success: false });
    if (stage === 'handshake') ecr.testConnection.mockResolvedValue({ success: false, connected: true });
    if (stage === 'connected') ecr.testConnection.mockResolvedValue({ success: true, connected: false });
    if (stage === 'missing-connected') ecr.testConnection.mockResolvedValue({ success: true });
    if (stage === 'malformed-connected') ecr.testConnection.mockResolvedValue({ success: true, connected: 'true' });
    const save = vi.fn();
    await expect(verifyAndSaveMyDataDevice(ecr, device(), false, 'terminal-a', connection, save)).rejects.toThrow();
    expect(save).not.toHaveBeenCalled();
  });

  it.each(['bluetooth', 'zvt', 'pax', 'missing-terminal', 'missing-port'])('blocks unsupported or unbound setup (%s) before native IO', async condition => {
    const ecr = setup();
    const save = vi.fn();
    await expect(verifyAndSaveMyDataDevice(ecr,
      { ...device(), connectionType: condition === 'bluetooth' ? 'bluetooth' : 'network' }, false,
      condition === 'missing-terminal' ? '' : 'terminal-a',
      { ...connection, protocol: ['zvt', 'pax'].includes(condition) ? condition : 'cap_driver', port: condition === 'missing-port' ? 0 : 1234 }, save,
    )).rejects.toThrow();
    expect(ecr.addDevice).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
});
