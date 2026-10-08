import type { getBridge } from '../../lib';
import { loadEcrDeviceAdmission } from './ecr-device-type';

export const MYDATA_FISCAL_DEVICE_ID = 'mydata-fiscal-device';
export type MyDataConnectionType = 'network' | 'usb_serial' | 'bluetooth';
export interface MyDataCapSettings {
  capturePath: string;
  outputPath: string;
  serviceName: string;
  fileEncoding: 'utf-8' | 'windows-1253';
  transactionTimeoutMs: number;
  cashPaymentCode: number;
  cardPaymentCode: number;
  eftPosIndex: number;
  probeDeviceTcp: boolean;
  /** Optional CAP voucher (gift) payment code; blank until a technician sets it. */
  voucherPaymentCode?: number;
}
export const DEFAULT_MYDATA_CAP_SETTINGS: MyDataCapSettings = {
  capturePath: 'C:\\Capture', outputPath: 'C:\\Capture\\Output',
  serviceName: 'CapDriverSVC', fileEncoding: 'utf-8',
  transactionTimeoutMs: 120000, cashPaymentCode: 1, cardPaymentCode: 2, eftPosIndex: 1,
  probeDeviceTcp: false,
};
export const normalizeMyDataProtocol = (protocol: string): string =>
  ['cap_driver', 'rbs_cap_driver', 'mat_cap_driver'].includes(protocol) ? 'cap_driver'
    : ['generic', 'escpos_fiscal', 'generic_escpos_fiscal'].includes(protocol) ? 'generic' : protocol;
export const isMyDataFiscalProtocol = (protocol: string): boolean =>
  ['cap_driver', 'generic'].includes(normalizeMyDataProtocol(protocol));
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};

export function myDataConnectionTypeFromSaved(value: unknown): MyDataConnectionType {
  const type = record(value).type;
  return type === 'usb_serial' || type === 'bluetooth' ? type : 'network';
}

const isBlankVoucherCode = (value: unknown): boolean => value === undefined || value === null || value === '';

/**
 * The optional CAP voucher (gift) payment code has no default. A set code must
 * be an integer 2–20 and differ from the configured cash and card codes; code 1
 * is always refused.
 */
export function myDataVoucherCodeIssue(voucher: unknown, cashPaymentCode: unknown, cardPaymentCode: unknown): 'invalid' | 'collision' | null {
  if (isBlankVoucherCode(voucher)) return null;
  if (typeof voucher !== 'number' || !Number.isInteger(voucher) || voucher < 2 || voucher > 20) return 'invalid';
  return voucher === cashPaymentCode || voucher === cardPaymentCode ? 'collision' : null;
}

export function readMyDataCapSettings(value: unknown): MyDataCapSettings {
  const source = record(value);
  const result = { ...DEFAULT_MYDATA_CAP_SETTINGS };
  for (const key of Object.keys(result) as (keyof MyDataCapSettings)[]) {
    const alias = key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
    const saved = source[key] ?? source[alias];
    // Preserve invalid configured values too: validation must reject them, not
    // silently replace a technician's setup with a working-looking default.
    if (saved !== undefined) Object.assign(result, { [key]: saved });
  }
  // The voucher code has no default; keep a technician's value exactly.
  const voucher = source.voucherPaymentCode ?? source.voucher_payment_code;
  if (!isBlankVoucherCode(voucher)) Object.assign(result, { voucherPaymentCode: voucher });
  const encoding = String(result.fileEncoding).trim().toLowerCase();
  if (['utf-8', 'utf8'].includes(encoding)) result.fileEncoding = 'utf-8';
  if (['windows-1253', 'cp1253', 'windows1253', 'ansi', 'ansi-1253', '1253', 'greek'].includes(encoding)) result.fileEncoding = 'windows-1253';
  if (source.outputPath === undefined && source.output_path === undefined && typeof result.capturePath === 'string') {
    result.outputPath = `${result.capturePath.replace(/[\\/]+$/, '')}\\Output`;
  }
  return result;
}

export function validateMyDataCapSettings(settings: MyDataCapSettings): boolean {
  return [settings.capturePath, settings.outputPath, settings.serviceName].every(value => typeof value === 'string' && value.trim().length > 0)
    && ['utf-8', 'windows-1253'].includes(settings.fileEncoding)
    && typeof settings.probeDeviceTcp === 'boolean'
    && Number.isInteger(settings.transactionTimeoutMs) && settings.transactionTimeoutMs >= 5000 && settings.transactionTimeoutMs <= 300000
    && [settings.cashPaymentCode, settings.cardPaymentCode].every(value => Number.isInteger(value) && value >= 1 && value <= 20)
    && Number.isInteger(settings.eftPosIndex) && settings.eftPosIndex >= 1 && settings.eftPosIndex <= 99
    && myDataVoucherCodeIssue(settings.voucherPaymentCode, settings.cashPaymentCode, settings.cardPaymentCode) === null;
}

// Only local device options are carried forward; credential-like fields never
// enter the setup draft or remote device_connection payload.
function nonSecretSettings(value: unknown): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record(value))
    .filter(([key]) => !/password|passwd|secret|token|credential|api.?key|authorization|private.?key|dev.?key|unlock|cap.?driver.?key/i.test(key))
    .map(([key, item]) => [key, Array.isArray(item)
      ? item.map(entry => entry && typeof entry === 'object' ? nonSecretSettings(entry) : entry)
      : item && typeof item === 'object' ? nonSecretSettings(item) : item]));
}

export function buildMyDataDeviceSettings(protocol: string, model: string, existing: unknown, cap: MyDataCapSettings): Record<string, unknown> {
  protocol = normalizeMyDataProtocol(protocol);
  const device = record(existing);
  const compatible = typeof device.protocol === 'string' && normalizeMyDataProtocol(device.protocol) === normalizeMyDataProtocol(protocol);
  if (protocol === 'cap_driver' && !validateMyDataCapSettings(cap)) throw new Error('Invalid CAP Driver settings');
  const settings: Record<string, unknown> = {
    ...(compatible ? nonSecretSettings(device.settings) : {}),
    mydataManaged: true, model, protocolProfile: protocol,
    ...(protocol === 'cap_driver' ? { ...cap, requireService: true, require_service: true } : {}),
  };
  if (protocol === 'cap_driver') {
    // One voucher key only, and a cleared code must not survive from the old device settings.
    delete settings.voucher_payment_code;
    if (isBlankVoucherCode(cap.voucherPaymentCode)) delete settings.voucherPaymentCode;
  }
  return settings;
}

type EcrSetupBridge = Pick<ReturnType<typeof getBridge>['ecr'], 'addDevice' | 'updateDevice' | 'connectDevice' | 'testConnection' | 'getDeviceAdmission'>;

export interface MyDataDeviceVerification<T> {
  /** The server save result (the caller checks its own success shape). */
  saved: T;
  /**
   * True only when the device ends enabled: the server save succeeded, the
   * refreshed admission says the store's MyData plugin is in fiscal-device
   * mode with its setup finished, and the device was enabled as the default
   * cash register (or an already active register got its own flags back,
   * which native allows only while MyData admits it).
   */
  activated: boolean;
}

/** The local device fields a failed re-verification puts back as they were. */
const RESTORED_DEVICE_FIELDS = [
  'name', 'brand', 'protocol', 'connectionType', 'connectionDetails', 'terminalId', 'merchantId',
  'operatorId', 'printMode', 'taxRates', 'settings',
] as const;
const storedFlag = (value: unknown): boolean => value === true || value === 1;

/**
 * The only path that may report connected runs the real native protocol test first.
 *
 * Founder rule 08/10/2026: a plugin that is not activated, configured and
 * finished has no effect. The managed cash register is saved DISABLED (native
 * refuses to enable a cash register before MyData is admitted), connected and
 * handshaken while disabled, reported to the server, and enabled only when the
 * refreshed admission confirms MyData is in fiscal-device mode and connected.
 * Otherwise it stays inactive and the caller tells the user why.
 *
 * Re-verifying an already active register (`existing` is its stored row) never
 * leaves it disabled after a transient failure: before the server holds the
 * new configuration, a failure puts the previous connection, settings and
 * flags back; after it, the verified configuration keeps the previous flags.
 * Native still refuses to enable it while MyData does not admit it.
 */
export async function verifyAndSaveMyDataDevice<T>(
  ecr: EcrSetupBridge,
  nativeDevice: { id: string; connectionType: string; settings: Record<string, unknown> },
  existing: boolean | Record<string, unknown>,
  terminalId: string,
  deviceConnection: Record<string, unknown>,
  save: (payload: { device_connection: Record<string, unknown>; status: 'connected' }) => Promise<T>,
): Promise<MyDataDeviceVerification<T>> {
  if (!terminalId.trim()) throw new Error('Terminal identity is unavailable; pair this POS again before verification');
  if (nativeDevice.connectionType === 'bluetooth') throw new Error('Direct Bluetooth is not available; use LAN or serial');
  if (!isMyDataFiscalProtocol(String(deviceConnection.protocol))) throw new Error('Choose an installed fiscal cashier protocol');
  if (deviceConnection.type === 'network') {
    const portRequired = normalizeMyDataProtocol(String(deviceConnection.protocol)) !== 'cap_driver' || nativeDevice.settings.probeDeviceTcp === true;
    const portPresent = deviceConnection.port !== undefined && deviceConnection.port !== null;
    if (typeof deviceConnection.host !== 'string' || !deviceConnection.host.trim() || ((portRequired || portPresent) && (!Number.isInteger(deviceConnection.port) || Number(deviceConnection.port) < 1 || Number(deviceConnection.port) > 65535))) throw new Error('A device host and valid ERP port are required');
  } else if (deviceConnection.type !== 'usb_serial' || typeof deviceConnection.serial_port !== 'string' || !deviceConnection.serial_port.trim()) {
    throw new Error('A supported device connection is required');
  }
  if (normalizeMyDataProtocol(String(deviceConnection.protocol)) === 'cap_driver' && (
    nativeDevice.settings.requireService !== true || !validateMyDataCapSettings(nativeDevice.settings as unknown as MyDataCapSettings)
  )) throw new Error('Invalid CAP Driver settings');
  const previous = existing && typeof existing === 'object' ? existing : null;
  const wasActive = previous !== null && storedFlag(previous.enabled);
  // Best effort: a failed restore leaves the register disabled, never enabled wrongly.
  const restoreFlags = async (): Promise<boolean> => {
    if (!wasActive || !previous) return false;
    try {
      const restored = await ecr.updateDevice(nativeDevice.id, { enabled: true, isDefault: storedFlag(previous.isDefault) });
      return restored?.success === true;
    } catch {
      return false;
    }
  };
  const restorePrevious = async (): Promise<void> => {
    if (!wasActive || !previous) return;
    const config = Object.fromEntries(RESTORED_DEVICE_FIELDS
      .filter(field => previous[field] !== undefined && previous[field] !== null)
      .map(field => [field, previous[field]]));
    try {
      await ecr.updateDevice(nativeDevice.id, { ...config, enabled: false, isDefault: false });
    } catch {
      // the flags below are still worth putting back
    }
    await restoreFlags();
  };
  const inactiveDevice = { ...nativeDevice, enabled: false, isDefault: false };
  const saved = existing ? await ecr.updateDevice(nativeDevice.id, inactiveDevice) : await ecr.addDevice(inactiveDevice);
  if (saved?.success !== true) throw new Error(saved?.error || 'Failed to save fiscal device locally');
  let result: T;
  try {
    const connected = await ecr.connectDevice(nativeDevice.id);
    if (connected?.success !== true) throw new Error(connected?.error || 'Fiscal device connection failed');
    const tested = await ecr.testConnection(nativeDevice.id);
    // Native ecr_test_connection returns `connected` at the top level; the generic
    // IPC result type does not describe that field, so inspect it at runtime.
    if (tested?.success !== true || record(tested).connected !== true) throw new Error(tested?.error || 'Fiscal protocol handshake failed');
    result = await save({
      device_connection: {
        ...deviceConnection,
        verification: { status: 'verified', terminal_id: terminalId, device_id: nativeDevice.id, verified_at: new Date().toISOString(), protocol_handshake: true },
      },
      status: 'connected',
    });
  } catch (error) {
    await restorePrevious();
    throw error;
  }
  if (record(result).success === false) {
    await restorePrevious();
    return { saved: result, activated: false };
  }
  // The server now holds the verified device; only its own answer admits it.
  const admission = await loadEcrDeviceAdmission(ecr);
  if (!admission?.cashRegister.admitted) return { saved: result, activated: await restoreFlags() };
  try {
    const enabled = await ecr.updateDevice(nativeDevice.id, { enabled: true, isDefault: true });
    if (enabled?.success === true) return { saved: result, activated: true };
  } catch {
    // fall through: an active register keeps its own flags
  }
  return { saved: result, activated: await restoreFlags() };
}

export function getMyDataCapPrefill(
  detected: { settings?: Partial<MyDataCapSettings>; target?: { type: 'network' | 'usb_serial'; host?: string; serial_port?: string; baud_rate?: number } },
  savedConnection: unknown, savedLocalSettings: unknown, edited: ReadonlySet<string>,
): { settings: Partial<MyDataCapSettings>; target?: typeof detected.target } {
  const saved = record(savedConnection);
  const local = record(savedLocalSettings);
  const settings: Partial<MyDataCapSettings> = {};
  for (const key of ['capturePath', 'outputPath', 'fileEncoding'] as const) {
    const alias = key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
    const value = detected.settings?.[key];
    // Without an explicit output path, native CAP derives it from capturePath.
    if (key === 'outputPath' && (local.capturePath !== undefined || local.capture_path !== undefined || edited.has('cap.capturePath'))) continue;
    if (!edited.has(`cap.${key}`) && local[key] === undefined && local[alias] === undefined && typeof value === 'string' && value.trim()) {
      if (key === 'fileEncoding') {
        if (value === 'utf-8' || value === 'windows-1253') settings.fileEncoding = value;
      } else settings[key] = value;
    }
  }
  const candidate = detected.target;
  if (!candidate || edited.has('target') || (saved.type && saved.type !== candidate.type)) return { settings };
  const target: NonNullable<typeof detected.target> = { type: candidate.type };
  if (candidate.type === 'network' && !saved.host && candidate.host?.trim()) target.host = candidate.host;
  if (candidate.type === 'usb_serial') {
    if (!saved.serial_port && !saved.port && candidate.serial_port?.trim()) target.serial_port = candidate.serial_port;
    if (!saved.baud_rate && Number.isInteger(candidate.baud_rate) && Number(candidate.baud_rate) > 0) target.baud_rate = candidate.baud_rate;
  }
  return { settings, target };
}

/** CAP uses the installed vendor service target, not the POS connection draft. */
export function myDataCapTargetMatches(
  status: { success: boolean; platformSupported: boolean; serviceInstalled: boolean; serviceRunning: boolean; code?: string; target?: { type: 'network' | 'usb_serial'; host?: string; serial_port?: string; baud_rate?: number } } | null,
  draft: { type: MyDataConnectionType; host: string; serialPort: string; baudRate: string },
): boolean {
  if (!status?.success || status.code !== undefined || !status.platformSupported || !status.serviceInstalled || !status.serviceRunning || !status.target) return false;
  const target = status.target;
  if (target.type !== draft.type) return false;
  if (target.type === 'network') return typeof target.host === 'string' && target.host.trim().length > 0 && target.host.trim().toLowerCase() === draft.host.trim().toLowerCase();
  return typeof target.serial_port === 'string' && target.serial_port.trim().length > 0
    && target.serial_port.trim().toUpperCase() === draft.serialPort.trim().toUpperCase()
    && Number.isInteger(target.baud_rate) && Number(target.baud_rate) > 0 && target.baud_rate === Number(draft.baudRate);
}
