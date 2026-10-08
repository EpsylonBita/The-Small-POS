import { describe, expect, it, vi } from 'vitest';
import {
  buildMyDataDeviceSettings, DEFAULT_MYDATA_CAP_SETTINGS, MYDATA_FISCAL_DEVICE_ID,
  myDataConnectionTypeFromSaved, readMyDataCapSettings, verifyAndSaveMyDataDevice,
  getMyDataCapPrefill,
  myDataCapTargetMatches, myDataVoucherCodeIssue, validateMyDataCapSettings,
} from '../mydata-device-setup';

const custom = {
  ...DEFAULT_MYDATA_CAP_SETTINGS, capturePath: 'D:\\Vendor\\In', outputPath: 'D:\\Vendor\\Out',
  serviceName: 'VendorCAP', fileEncoding: 'windows-1253' as const,
  transactionTimeoutMs: 180000, cashPaymentCode: 4, cardPaymentCode: 7, eftPosIndex: 8,
};
const connection = { type: 'network', host: '192.168.1.50', port: 1234, protocol: 'cap_driver', brand: 'RBS', model: 'configured model' };
const device = () => ({ id: MYDATA_FISCAL_DEVICE_ID, connectionType: 'network', settings: buildMyDataDeviceSettings('cap_driver', 'configured model', null, custom) });
const admissionAnswer = (cashAdmitted: boolean, status = cashAdmitted ? 'connected' : 'pending') => ({
  success: true,
  cardTerminal: { admitted: false, fetchedAt: '2026-10-08T09:00:00Z' },
  cashRegister: { admitted: cashAdmitted, fetchedAt: '2026-10-08T09:00:00Z', mode: 'fiscal_device', status },
});
const setup = () => ({
  addDevice: vi.fn().mockResolvedValue({ success: true }), updateDevice: vi.fn().mockResolvedValue({ success: true }),
  connectDevice: vi.fn().mockResolvedValue({ success: true }), testConnection: vi.fn().mockResolvedValue({ success: true, connected: true }),
  getDeviceAdmission: vi.fn().mockResolvedValue(admissionAnswer(true)),
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

  // Founder rule 08/10/2026: an unfinished MyData plugin has no effect. Incident:
  // a cash register was enabled while MyData (fiscal_device) was still `pending`.
  it('saves the fiscal device disabled and enables it only after the server admits MyData', async () => {
    const ecr = setup();
    const save = vi.fn().mockResolvedValue({ success: true, data: { config: { mode: 'fiscal_device', status: 'connected' } } });
    const result = await verifyAndSaveMyDataDevice(ecr, device(), false, 'terminal-a', connection, save);
    expect(ecr.addDevice).toHaveBeenCalledWith(expect.objectContaining({ id: MYDATA_FISCAL_DEVICE_ID, enabled: false, isDefault: false }));
    expect(ecr.getDeviceAdmission).toHaveBeenCalledWith({ refresh: true });
    expect(ecr.updateDevice).toHaveBeenCalledExactlyOnceWith(MYDATA_FISCAL_DEVICE_ID, { enabled: true, isDefault: true });
    // Order: native save (disabled) -> connect -> handshake -> server save -> admission -> enable.
    expect(ecr.addDevice.mock.invocationCallOrder[0]).toBeLessThan(ecr.connectDevice.mock.invocationCallOrder[0]);
    expect(ecr.connectDevice.mock.invocationCallOrder[0]).toBeLessThan(ecr.testConnection.mock.invocationCallOrder[0]);
    expect(ecr.testConnection.mock.invocationCallOrder[0]).toBeLessThan(save.mock.invocationCallOrder[0]);
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(ecr.getDeviceAdmission.mock.invocationCallOrder[0]);
    expect(ecr.getDeviceAdmission.mock.invocationCallOrder[0]).toBeLessThan(ecr.updateDevice.mock.invocationCallOrder[0]);
    expect(result).toEqual({ saved: { success: true, data: { config: { mode: 'fiscal_device', status: 'connected' } } }, activated: true });
  });

  it('re-verifies an existing device disabled first, so native never refuses the save', async () => {
    const ecr = setup();
    const save = vi.fn().mockResolvedValue({ success: true });
    await verifyAndSaveMyDataDevice(ecr, device(), true, 'terminal-a', connection, save);
    expect(ecr.updateDevice.mock.calls[0]).toEqual([MYDATA_FISCAL_DEVICE_ID, expect.objectContaining({ enabled: false, isDefault: false })]);
    expect(ecr.updateDevice.mock.calls[1]).toEqual([MYDATA_FISCAL_DEVICE_ID, { enabled: true, isDefault: true }]);
    expect(ecr.addDevice).not.toHaveBeenCalled();
  });

  // Review of PR #335: re-verifying an already active register cleared its
  // flags first, so any transient failure left a working register disabled.
  describe('re-verifying an already active register', () => {
    const activeRow = () => ({
      id: MYDATA_FISCAL_DEVICE_ID, deviceType: 'cash_register', name: 'RBS old', brand: 'RBS', protocol: 'cap_driver',
      connectionType: 'network', connectionDetails: { ip: '192.168.1.40' }, printMode: 'register_prints',
      taxRates: [{ code: 'A', rate: 24 }], settings: { mydataManaged: true, capturePath: 'C:\\Capture' },
      terminalId: null, enabled: 1, isDefault: 1, admitted: true,
    });
    const previousConfig = {
      name: 'RBS old', brand: 'RBS', protocol: 'cap_driver', connectionType: 'network',
      connectionDetails: { ip: '192.168.1.40' }, printMode: 'register_prints', taxRates: [{ code: 'A', rate: 24 }],
      settings: { mydataManaged: true, capturePath: 'C:\\Capture' }, enabled: false, isDefault: false,
    };

    it.each([
      ['the connection', (ecr: ReturnType<typeof setup>) => ecr.connectDevice.mockResolvedValue({ success: false, error: 'offline' })],
      ['the handshake', (ecr: ReturnType<typeof setup>) => ecr.testConnection.mockResolvedValue({ success: true, connected: false })],
      ['the server save', (ecr: ReturnType<typeof setup>) => ecr.testConnection.mockResolvedValue({ success: true, connected: true })],
    ])('a failure of %s before the server holds the new setup puts the previous register back', async (label, arrange) => {
      const ecr = setup();
      arrange(ecr);
      const save = label === 'the server save' ? vi.fn().mockRejectedValue(new Error('network')) : vi.fn();
      await expect(verifyAndSaveMyDataDevice(ecr, device(), activeRow(), 'terminal-a', connection, save)).rejects.toThrow();
      expect(ecr.updateDevice.mock.calls.slice(1)).toEqual([
        [MYDATA_FISCAL_DEVICE_ID, previousConfig],
        [MYDATA_FISCAL_DEVICE_ID, { enabled: true, isDefault: true }],
      ]);
    });

    it('a refused server save puts the previous register back and reports whether it is active', async () => {
      const ecr = setup();
      const refused = vi.fn().mockResolvedValue({ success: false, error: 'Server refused' });
      expect(await verifyAndSaveMyDataDevice(ecr, device(), activeRow(), 'terminal-a', connection, refused))
        .toEqual({ saved: { success: false, error: 'Server refused' }, activated: false });
      expect(ecr.updateDevice.mock.calls.slice(1)).toEqual([
        [MYDATA_FISCAL_DEVICE_ID, previousConfig],
        [MYDATA_FISCAL_DEVICE_ID, { enabled: true, isDefault: true }],
      ]);
      expect(ecr.getDeviceAdmission).not.toHaveBeenCalled();
    });

    it('an unreadable admission after the save keeps the verified setup with the previous flags; native decides', async () => {
      const ecr = setup();
      ecr.getDeviceAdmission.mockRejectedValue(new Error('ipc failed'));
      const save = vi.fn().mockResolvedValue({ success: true });
      expect((await verifyAndSaveMyDataDevice(ecr, device(), activeRow(), 'terminal-a', connection, save)).activated).toBe(true);
      expect(ecr.updateDevice.mock.calls.slice(1)).toEqual([[MYDATA_FISCAL_DEVICE_ID, { enabled: true, isDefault: true }]]);

      const notAdmitted = setup();
      notAdmitted.getDeviceAdmission.mockResolvedValue(admissionAnswer(false));
      notAdmitted.updateDevice.mockResolvedValueOnce({ success: true })
        .mockResolvedValue({ success: false, code: 'DEVICE_NOT_ADMITTED', error: 'not admitted' });
      expect((await verifyAndSaveMyDataDevice(notAdmitted, device(), activeRow(), 'terminal-a', connection, save)).activated).toBe(false);
    });

    it('a register that was not active is never enabled by a failed verification', async () => {
      const ecr = setup();
      ecr.testConnection.mockResolvedValue({ success: false, error: 'handshake failed' });
      await expect(verifyAndSaveMyDataDevice(ecr, device(), { ...activeRow(), enabled: 0 }, 'terminal-a', connection, vi.fn()))
        .rejects.toThrow('handshake failed');
      expect(ecr.updateDevice).toHaveBeenCalledOnce();
      expect(ecr.updateDevice.mock.calls[0][1]).toMatchObject({ enabled: false, isDefault: false });
    });
  });

  it.each(['pending', 'inactive', 'error'])('leaves a verified device inactive while MyData is %s', async status => {
    const ecr = setup();
    ecr.getDeviceAdmission.mockResolvedValue(admissionAnswer(false, status));
    const save = vi.fn().mockResolvedValue({ success: true });
    const result = await verifyAndSaveMyDataDevice(ecr, device(), false, 'terminal-a', connection, save);
    expect(result.activated).toBe(false);
    expect(ecr.updateDevice).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledOnce();
  });

  it('stays inactive when the admission cannot be read, and falls back to the last known answer', async () => {
    const ecr = setup();
    ecr.getDeviceAdmission.mockRejectedValue(new Error('ipc failed'));
    const save = vi.fn().mockResolvedValue({ success: true });
    expect((await verifyAndSaveMyDataDevice(ecr, device(), false, 'terminal-a', connection, save)).activated).toBe(false);
    expect(ecr.updateDevice).not.toHaveBeenCalled();

    const fallback = setup();
    fallback.getDeviceAdmission.mockRejectedValueOnce(new Error('refresh failed')).mockResolvedValueOnce(admissionAnswer(true));
    expect((await verifyAndSaveMyDataDevice(fallback, device(), false, 'terminal-a', connection, save)).activated).toBe(true);
    expect(fallback.getDeviceAdmission.mock.calls).toEqual([[{ refresh: true }], []]);
  });

  it('does not ask for admission or enable when the server save failed, nor report an enable native refused', async () => {
    const ecr = setup();
    const failed = vi.fn().mockResolvedValue({ success: false, error: 'Server refused' });
    expect(await verifyAndSaveMyDataDevice(ecr, device(), false, 'terminal-a', connection, failed))
      .toEqual({ saved: { success: false, error: 'Server refused' }, activated: false });
    expect(ecr.getDeviceAdmission).not.toHaveBeenCalled();
    expect(ecr.updateDevice).not.toHaveBeenCalled();

    const refused = setup();
    refused.updateDevice.mockResolvedValue({ success: false, code: 'DEVICE_NOT_ADMITTED', deviceType: 'cash_register', error: 'not admitted' });
    const save = vi.fn().mockResolvedValue({ success: true });
    expect((await verifyAndSaveMyDataDevice(refused, device(), false, 'terminal-a', connection, save)).activated).toBe(false);
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

  it('keeps an optional CAP voucher code exactly, with no default and one settings key', () => {
    expect(readMyDataCapSettings(custom)).not.toHaveProperty('voucherPaymentCode');
    expect(readMyDataCapSettings({ ...custom, voucher_payment_code: 9 }).voucherPaymentCode).toBe(9);
    // An invalid saved code is kept so validation refuses it instead of dropping it.
    expect(readMyDataCapSettings({ ...custom, voucherPaymentCode: 1 }).voucherPaymentCode).toBe(1);
    expect(buildMyDataDeviceSettings('cap_driver', 'm', null, custom)).not.toHaveProperty('voucherPaymentCode');
    const existing = { protocol: 'cap_driver', settings: { ...custom, voucherPaymentCode: 9, voucher_payment_code: 9, mode: 'kept' } };
    const kept = buildMyDataDeviceSettings('cap_driver', 'm', existing, { ...custom, voucherPaymentCode: 9 });
    expect(kept).toMatchObject({ voucherPaymentCode: 9, mode: 'kept' });
    expect(kept).not.toHaveProperty('voucher_payment_code');
    const cleared = buildMyDataDeviceSettings('cap_driver', 'm', existing, custom);
    expect(cleared).not.toHaveProperty('voucherPaymentCode');
    expect(cleared).not.toHaveProperty('voucher_payment_code');
  });

  it('accepts a voucher code 2–20 that differs from the cash and card codes', () => {
    expect(myDataVoucherCodeIssue(undefined, 4, 7)).toBeNull();
    expect(myDataVoucherCodeIssue('', 4, 7)).toBeNull();
    expect(myDataVoucherCodeIssue(9, 4, 7)).toBeNull();
    for (const code of [1, 0, 21, 2.5, '9', Number.NaN]) expect(myDataVoucherCodeIssue(code, 4, 7)).toBe('invalid');
    expect(myDataVoucherCodeIssue(4, 4, 7)).toBe('collision');
    expect(myDataVoucherCodeIssue(7, 4, 7)).toBe('collision');
    expect(validateMyDataCapSettings({ ...custom, voucherPaymentCode: 9 })).toBe(true);
    expect(validateMyDataCapSettings({ ...custom, voucherPaymentCode: 7 })).toBe(false);
    expect(validateMyDataCapSettings({ ...custom, voucherPaymentCode: 1 })).toBe(false);
    expect(() => buildMyDataDeviceSettings('cap_driver', 'm', null, { ...custom, voucherPaymentCode: 4 })).toThrow('Invalid CAP Driver settings');
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
