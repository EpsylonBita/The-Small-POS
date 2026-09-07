import { beforeEach, expect, it, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
import { TauriBridge, type WindowsSettingsSection } from '../ipc-adapter';

beforeEach(() => { invoke.mockReset(); });

it.each<WindowsSettingsSection>(['display', 'sound', 'touch', 'power'])(
  'passes the %s section to the dedicated native settings allowlist', async (section) => {
    invoke.mockResolvedValue({ success: true, section });
    await expect(new TauriBridge().system.openSettings(section)).resolves.toEqual({ success: true, section });
    expect(invoke).toHaveBeenCalledWith('system_open_settings', { arg0: { section } });
  },
);

it('propagates unsupported-platform errors instead of reporting settings opened', async () => {
  invoke.mockRejectedValue(new Error('Opening system settings is supported only on Windows'));
  await expect(new TauriBridge().system.openSettings('display')).rejects.toThrow('supported only on Windows');
});
