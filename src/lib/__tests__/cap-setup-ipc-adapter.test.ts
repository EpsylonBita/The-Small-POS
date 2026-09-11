import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
import {
  CAP_SETUP_ACTIONS,
  CHANNEL_MAP,
  TauriBridge,
  type CapSetupAction,
  type CapSetupResult,
} from '../ipc-adapter';

beforeEach(() => {
  invoke.mockReset();
});

describe('bridge.ecr.capSetup', () => {
  it.each<CapSetupAction>(['status', 'open_installer'])(
    'maps the %s action onto the single native cap-setup command',
    async (action) => {
      const result: CapSetupResult = {
        success: true,
        platformSupported: true,
        serviceInstalled: false,
        serviceRunning: false,
        code: 'CAP_SETUP_SERVICE_ABSENT',
      };
      invoke.mockResolvedValue(result);

      await expect(new TauriBridge().ecr.capSetup(action)).resolves.toEqual(result);
      expect(invoke).toHaveBeenCalledWith('ecr_cap_setup', { arg0: action });
    },
  );

  it('exposes exactly the two documented actions', () => {
    expect(CAP_SETUP_ACTIONS).toEqual(['status', 'open_installer']);
  });

  it('is reachable through the channel map under its own channel', () => {
    expect(CHANNEL_MAP['ecr:cap-setup']).toBe('ecr.capSetup');
  });

  it.each([
    'install',
    'start_service',
    'STATUS',
    'open_installer;calc.exe',
    'C:\\Users\\Public\\setup.exe',
    'https://example.test/installer.zip',
    '',
  ])('refuses %p at the runtime allowlist without invoking anything', async (action) => {
    await expect(
      new TauriBridge().ecr.capSetup(action as CapSetupAction),
    ).rejects.toThrow('CAP_SETUP_UNKNOWN_ACTION');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('passes no path, url or command line alongside the action', async () => {
    invoke.mockResolvedValue({
      success: true,
      platformSupported: true,
      serviceInstalled: false,
      serviceRunning: false,
      installerLaunched: true,
      code: 'CAP_SETUP_INSTALLER_LAUNCHED',
    });

    await new TauriBridge().ecr.capSetup('open_installer');

    const [, payload] = invoke.mock.calls[0] as [string, Record<string, unknown>];
    expect(Object.keys(payload)).toEqual(['arg0']);
  });

  it('surfaces the native single-flight refusal instead of a second launch', async () => {
    // The bridge deliberately does not de-duplicate: the native command owns
    // the single-flight guard, so a double click must come back as a refusal
    // and never as a second launch.
    invoke
      .mockResolvedValueOnce({
        success: true,
        platformSupported: true,
        serviceInstalled: false,
        serviceRunning: false,
        installerLaunched: true,
        code: 'CAP_SETUP_INSTALLER_LAUNCHED',
      } satisfies CapSetupResult)
      .mockResolvedValueOnce({
        success: false,
        platformSupported: true,
        serviceInstalled: false,
        serviceRunning: false,
        installerLaunched: false,
        code: 'CAP_SETUP_ALREADY_IN_PROGRESS',
      } satisfies CapSetupResult);

    const bridge = new TauriBridge();
    const first = await bridge.ecr.capSetup('open_installer');
    // The first launch response already arrived, but its installer is open.
    const second = await bridge.ecr.capSetup('open_installer');

    expect(first.installerLaunched).toBe(true);
    expect(second.success).toBe(false);
    expect(second.installerLaunched).toBe(false);
    expect(second.code).toBe('CAP_SETUP_ALREADY_IN_PROGRESS');
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('propagates a native rejection instead of reporting a launch', async () => {
    invoke.mockRejectedValue(new Error('CAP_SETUP_UNKNOWN_ACTION'));
    await expect(new TauriBridge().ecr.capSetup('status')).rejects.toThrow(
      'CAP_SETUP_UNKNOWN_ACTION',
    );
  });

  it('surfaces an unsupported platform as a failed result, never as an install', async () => {
    invoke.mockResolvedValue({
      success: false,
      platformSupported: false,
      serviceInstalled: false,
      serviceRunning: false,
      code: 'CAP_SETUP_PLATFORM_UNSUPPORTED',
    } satisfies CapSetupResult);

    const result = await new TauriBridge().ecr.capSetup('open_installer');

    expect(result.success).toBe(false);
    expect(result.platformSupported).toBe(false);
    expect(result.installerLaunched).toBeUndefined();
  });
});
