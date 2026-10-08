import { beforeEach, expect, it, vi } from 'vitest';
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
import { CHANNEL_MAP, TauriBridge } from '../ipc-adapter';

// Founder rule 08/10/2026: device admission is read through one native command.
beforeEach(() => { invoke.mockReset(); });

const answer = {
  success: true,
  cardTerminal: { admitted: false, fetchedAt: null },
  cashRegister: { admitted: false, fetchedAt: null, mode: null, status: null },
};

it('asks native to refresh the admission through ecr_get_device_admission', async () => {
  invoke.mockResolvedValue(answer);
  expect(await new TauriBridge().ecr.getDeviceAdmission({ refresh: true })).toEqual(answer);
  expect(invoke).toHaveBeenCalledWith('ecr_get_device_admission', { arg0: { refresh: true } });
  expect(CHANNEL_MAP['ecr:get-device-admission']).toBe('ecr.getDeviceAdmission');
});

it('reads the last known admission without an argument', async () => {
  invoke.mockResolvedValue(answer);
  await new TauriBridge().ecr.getDeviceAdmission();
  expect(invoke).toHaveBeenCalledWith('ecr_get_device_admission', undefined);
});
